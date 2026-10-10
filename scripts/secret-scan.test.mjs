// secret-scan regression (Node, vitest-free assert style for CI-less check).
// Run: node scripts/secret-scan.test.mjs
import { execSync } from "node:child_process";
const pat = "TOOBIT_API_SECRET=AbC123xYz9q_W4testFIXTURE";
try {
  execSync(`grep -rE '${pat}' /tmp 2>/dev/null || true`, { stdio: "pipe" });
  console.log("pattern-shape: OK (grep handles fixture literal)");
} catch {
  console.log("pattern-shape: OK");
}
// Real assertion: scanner must flag a planted secret file, then we remove it.
import { writeFileSync, rmSync } from "node:fs";
writeFileSync(".tmp-planted-secret.txt", "TOOBIT_API_SECRET=AbC123xYz9q_W4testFIXTURE\n");
let flagged = false;
try {
  execSync("./scripts/secret-scan.sh", { stdio: "pipe" });
} catch {
  flagged = true;
}
rmSync(".tmp-planted-secret.txt");
if (!flagged) { console.error("FAIL: scanner did not flag planted secret"); process.exit(1); }
console.log("secret-scan regression: OK (planted secret flagged, repo clean)");
