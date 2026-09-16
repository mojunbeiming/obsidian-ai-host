// Delegates to the shared verifier so the rules live in one place.
//
// The plugin root is passed explicitly rather than inferred, so the check
// reports on THIS plugin no matter which directory npm happened to run from.
// (Getting that wrong is silent: the shared script would otherwise happily
// verify whichever plugin was the working directory.)
//
//   node scripts/verify-bundle.cjs
const path = require("node:path");
process.env.SFC_PLUGIN_ROOT = path.resolve(__dirname, "..");
require("../tools/verify-bundle.cjs");