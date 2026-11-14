# Working preferences

After finishing and verifying Voice Kit changes, deploy the new server binary and
reload the running `voice-kit` plugin automatically. Verify the live plugin and
speech server after deployment. The user expects the running installation to
match the latest completed build; do not leave verified work only in the checkout.

Use the plugin's reload command. Never restart the Paseo daemon or interrupt other
agents. Keep the previous binary available for rollback during deployment.
Do not push commits unless requested.

Delegate all future UI changes, including UI copy, to Claude. Do not have GPT write
or rewrite UI wording. Keep benchmark figures and test methodology in docs/eval.md,
not in the model selection UI.

Keep evaluation runs short. Verify actual GPU use where acceleration is needed,
start with a small sample, and enforce time budgets before expanding a run.
