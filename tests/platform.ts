// The platform this app's tests run against: omnishell where mise puts it,
// under its own test config (pronto's docs/monorepo.md).
import "@bonisoft3/omnishell/interpreter/vendor/ses.umd.min.js";
export { baseUrl } from "@bonisoft3/omnishell/base-url.ts";
export { batched } from "@bonisoft3/omnishell/interpreter/batched-store.js";
export { createStore } from "@bonisoft3/omnishell/interpreter/data-sync.js";
export { parseFilter, parseLimit } from "@bonisoft3/omnishell/interpreter/fragment.js";
export { ensureSes, evaluateRole } from "@bonisoft3/omnishell/interpreter/jessie.js";
export { buildNodes } from "@bonisoft3/omnishell/interpreter/render.js";
export { interpretScreen } from "@bonisoft3/omnishell/interpreter/screen.js";
export { compileCatalog } from "@bonisoft3/omnishell/interpreter/vendor/messages.js";
export { type Machine, walk } from "@bonisoft3/omnishell/test/mecha-battery.ts";
export { executeMecha } from "@bonisoft3/omnishell/test/mecha-local.ts";
export { executeFunction } from "@bonisoft3/omnishell/test/function-local.ts";
