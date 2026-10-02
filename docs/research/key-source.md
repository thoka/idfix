# Which OpenRouter key does opencode use for a directory?

Date: 2026-09-28. opencode 1.18.32, `@opencode-ai/sdk` 1.18.32.

## Question

Each project has its own OpenRouter key, so that OpenRouter shows the cost and the limit of each project. `oc-sub ping` must show which key the opencode server uses for a directory, where that key comes from, and whether OpenRouter accepts it.

## Findings

The server resolves the provider configuration for each directory. `GET /config/providers?directory=DIR` (SDK: `client.config.providers({ query: { directory } })`) returns the provider `openrouter` after opencode merged the project `opencode.json`, the global `~/.config/opencode/opencode.jsonc`, the environment, and `~/.local/share/opencode/auth.json`. A `{file:...}` reference is already replaced by the content of the file.

If a configuration file sets the key, it is in `options.apiKey`. Otherwise it is in `key`, for example from `auth.json`.

The field `source` does not tell the origin of the key. A test gave `source: "config"` for a project key file, for a global configuration key, and for the key in `auth.json`. So `oc-sub` finds the origin itself: it compares the resolved key with the known candidates.

The order of precedence, from a test with three directories:

1. `apiKey` in the project `opencode.json`, for example `{file:~/.config/<project>/openrouter.key}`.
2. `apiKey` in the global `~/.config/opencode/opencode.jsonc`. It beats `auth.json`. A dead key there broke every project without its own key.
3. The key that `opencode auth login` wrote into `~/.local/share/opencode/auth.json`.

The environment variable `OPENROUTER_API_KEY` of the server process also counts. `oc-sub` only sees its own environment, which can differ from the environment of the server.

The server caches the configuration. After a change of a configuration file, the server reports the old key until `oc-sub restart`.

`GET https://openrouter.ai/api/v1/key` with `Authorization: Bearer <key>` checks a key and costs nothing. It returns HTTP 200 with `data.limit` (USD or null for no limit), `data.limit_remaining`, and `data.usage`. A revoked key gives HTTP 401 with `error.message` "User not found.". The field `data.label` holds a masked form of the key. `oc-sub` does not print it and uses a short SHA-256 fingerprint instead.

## Sources

- opencode configuration and variable substitution: https://opencode.ai/docs/config/
- OpenRouter key endpoint: https://openrouter.ai/docs/api-reference/api-keys/get-current-key
- Own tests against the local server, see above.
