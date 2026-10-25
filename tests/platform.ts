// The platform this app's tests run against: omnishell at the release
// .mise.toml installs, by its mirror's raw URLs. apps/deno.json maps it to the
// checkout in the monorepo.
import "https://raw.githubusercontent.com/bonisoft3/omnishell/v0.19.1/interpreter/vendor/ses.umd.min.js";
export { baseUrl } from "https://raw.githubusercontent.com/bonisoft3/omnishell/v0.19.1/base-url.ts";
export { batched } from "https://raw.githubusercontent.com/bonisoft3/omnishell/v0.19.1/interpreter/batched-store.js";
export { createStore } from "https://raw.githubusercontent.com/bonisoft3/omnishell/v0.19.1/interpreter/data-sync.js";
export { parseFilter, parseLimit } from "https://raw.githubusercontent.com/bonisoft3/omnishell/v0.19.1/interpreter/fragment.js";
export { ensureSes, evaluateRole } from "https://raw.githubusercontent.com/bonisoft3/omnishell/v0.19.1/interpreter/jessie.js";
export { buildNodes } from "https://raw.githubusercontent.com/bonisoft3/omnishell/v0.19.1/interpreter/render.js";
export { interpretScreen } from "https://raw.githubusercontent.com/bonisoft3/omnishell/v0.19.1/interpreter/screen.js";
export { compileCatalog } from "https://raw.githubusercontent.com/bonisoft3/omnishell/v0.19.1/interpreter/vendor/messages.js";
