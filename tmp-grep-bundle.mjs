import fs from "node:fs";

const BUNDLE = "C:/Users/cz/AppData/Local/Programs/Devin/resources/app/out/vs/sessions/sessions.desktop.main.js";
const src = fs.readFileSync(BUNDLE, "utf8");
const needles = process.argv.slice(2);
for (const needle of needles) {
    console.log("\n############ needle: " + JSON.stringify(needle) + " ############");
    let idx = 0;
    let hits = 0;
    while (hits < 12) {
        const at = src.indexOf(needle, idx);
        if (at === -1) break;
        hits++;
        const ctx = src.slice(Math.max(0, at - 350), Math.min(src.length, at + 350)).replace(/\n/g, "\\n");
        console.log("\n--- hit " + hits + " @offset " + at + " ---\n" + ctx);
        idx = at + needle.length;
    }
    if (hits === 0) console.log("(no hits)");
    else if (hits >= 12) console.log("\n(...more hits truncated)");
}