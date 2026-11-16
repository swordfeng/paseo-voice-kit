import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaseoModels, PASEO_MODELS, isPaseoModel, paseoModelsDir, type PaseoModelState } from "../plugin/server/paseo-models";

const temporary = await mkdtemp(join(tmpdir(), "vk-shared-models-"));
const root = join(temporary, "paseo"), local = join(temporary, "voicekit");
const id = "sensevoice-int8", spec = PASEO_MODELS[id];
const exists = (path: string) => access(path).then(() => true, () => false);
async function weights(base: string, value = "same pinned fixture") {
  await mkdir(join(base, spec.dir), { recursive: true });
  for (const file of spec.files) await writeFile(join(base, spec.dir, file), value + file);
}
let downloads = 0, deletes = 0, deleteCalls = 0, installedCallbacks = 0, busy = false, inUse = false;
const client = {
  async listLocalSpeechModels(): Promise<PaseoModelState[]> {
    return [{ id: spec.id, status: busy ? "downloading" : await exists(join(root, spec.dir, spec.files[0])) ? "installed" : "not_installed", inUse }];
  },
  async downloadLocalSpeechModel() { downloads++; await weights(root); },
  async deleteLocalSpeechModel() {
    deleteCalls++;
    if (busy || inUse) throw new Error("Paseo model is busy or in use");
    deletes++; await rm(join(root, spec.dir), { recursive: true, force: true });
  },
  async close() {},
};
const manager = new PaseoModels({ connect: async () => client, root: async () => root, localDir: local, installed: async () => { installedCallbacks++; } });
try {
  assert(isPaseoModel(id)); assert(!isPaseoModel("whisper-turbo"));
  await Promise.all([manager.ensure(id), manager.ensure(id)]);
  assert.equal(downloads, 1); assert.equal(installedCallbacks, 1);
  assert(await exists(join(root, spec.dir))); assert(!(await exists(join(local, spec.dir))));
  await manager.ensure(id); assert.equal(downloads, 1, "installed shared files need no second transfer");
  inUse = true; await assert.rejects(() => manager.remove(id), /in use/); assert.equal(deleteCalls, 0); assert(await exists(join(root, spec.dir)));
  inUse = false; await manager.remove(id); assert.equal(deletes, 1); assert.equal(manager.state(id)?.status, "not_installed");
  await weights(root); await manager.list(true); assert.equal(manager.state(id)?.status, "installed", "Paseo-origin installs are seen immediately");
  await rm(join(root, spec.dir), { recursive: true }); await manager.list(true); assert.equal(manager.state(id)?.status, "not_installed", "Paseo-origin deletion is the same source of truth");
  await weights(local); await manager.adopt();
  assert(!(await exists(join(root, spec.dir))), "deleted shared model must not be re-adopted from private storage");
  // An unclaimed private cache has no ownership/deletion history.
  await rm(join(local, ".paseo-shared-history"), { recursive: true, force: true });
  await manager.adopt();
  assert(await exists(join(root, spec.dir))); assert(!(await exists(join(local, spec.dir))), "move private files without downloading");
  await weights(local); await manager.adopt(); assert(!(await exists(join(local, spec.dir))), "remove byte-identical duplicate");
  await weights(local, "different fixture"); await manager.adopt(); assert(await exists(join(local, spec.dir)), "keep differing private files");
  await manager.remove(id); await manager.adopt();
  assert(!(await exists(join(root, spec.dir))), "retained differing files cannot resurrect a deleted model");
  assert(!(await exists(join(local, spec.dir))), "removing the model also removes its older private copy");
  await rm(join(local, spec.dir), { recursive: true, force: true }); await rm(join(root, spec.dir), { recursive: true, force: true });
  await rm(join(local, ".paseo-shared-history"), { recursive: true, force: true });
  await weights(local); busy = true; await manager.adopt(); assert(await exists(join(local, spec.dir))); assert(!(await exists(join(root, spec.dir))), "do not adopt over an active Paseo download");
  busy = false; await mkdir(join(root, ".downloads"), { recursive: true }); await writeFile(join(root, ".downloads", spec.dir + ".tar.bz2"), "unfinished archive");
  await manager.adopt(); assert(await exists(join(local, spec.dir)), "leave Paseo's unfinished extraction alone");
  const aliasLocal = join(temporary, "alias-local"), aliasRoot = join(temporary, "alias-canonical");
  await weights(aliasLocal);
  await symlink(aliasLocal, aliasRoot, "junction");
  const aliased = new PaseoModels({ connect: async () => client, root: async () => aliasRoot, localDir: aliasLocal });
  await aliased.adopt();
  assert(await exists(join(aliasLocal, spec.dir, spec.files[0])), "parent symlink aliases must preserve the only weights");
  assert(await exists(join(aliasRoot, spec.dir, spec.files[0])));
  await aliased.dispose();
  const nestedRoot = join(aliasLocal, spec.dir, "nested-canonical");
  await weights(nestedRoot);
  const nested = new PaseoModels({ connect: async () => client, root: async () => nestedRoot, localDir: aliasLocal });
  await nested.adopt();
  assert(await exists(join(aliasLocal, spec.dir, spec.files[0])), "a canonical directory under the private copy must not be recursively deleted");
  assert(await exists(join(nestedRoot, spec.dir, spec.files[0])));
  await nested.dispose();
  const sideLocal = join(temporary, "side-local"), sideRoot = join(temporary, "side-canonical");
  await weights(sideLocal); await weights(sideRoot);
  await writeFile(join(sideLocal, spec.dir, "unique-sidecar.json"), "keep me");
  const sidecars = new PaseoModels({ connect: async () => client, root: async () => sideRoot, localDir: sideLocal });
  await sidecars.adopt();
  assert(await exists(join(sideLocal, spec.dir, "unique-sidecar.json")), "only compared files belong to duplicate cleanup");
  assert(!(await exists(join(sideLocal, spec.dir, spec.files[0]))));
  assert(await exists(join(sideRoot, spec.dir, spec.files[0])));
  await sidecars.dispose();
  const oldHome = process.env.PASEO_HOME, oldModels = process.env.PASEO_LOCAL_MODELS_DIR;
  try {
    process.env.PASEO_HOME = temporary; delete process.env.PASEO_LOCAL_MODELS_DIR;
    assert.equal(await paseoModelsDir(), null, "an unreadable config disables sharing without throwing");
    await writeFile(join(temporary, "config.json"), JSON.stringify({ providers: { local: { modelsDir: "relative-cache" } } }));
    assert.equal(await paseoModelsDir(), null, "never guess a different canonical directory from the daemon");
    await writeFile(join(temporary, "config.json"), JSON.stringify({ providers: { local: { modelsDir: root } } }));
    assert.equal(await paseoModelsDir(), root);
    const unavailable = new PaseoModels({ connect: async () => client, root: async () => null, localDir: local });
    await unavailable.adopt(); await assert.rejects(() => unavailable.ensure(id), /directory is unavailable/); await unavailable.dispose();
  } finally {
    if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
    if (oldModels === undefined) delete process.env.PASEO_LOCAL_MODELS_DIR; else process.env.PASEO_LOCAL_MODELS_DIR = oldModels;
  }
  console.log("PASS shared transfer deduplication, both-origin install/delete state, in-use deletion guard, move/duplicate adoption and conflict safety");
} finally { await manager.dispose(); await rm(temporary, { recursive: true, force: true }); }
