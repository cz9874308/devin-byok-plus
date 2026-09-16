import fs from "node:fs";

const BUNDLE = "C:/Users/cz/AppData/Local/Programs/Devin/resources/app/out/vs/sessions/sessions.desktop.main.js";
const src = fs.readFileSync(BUNDLE, "utf8");
const offset = parseInt(process.argv[2], 10);
const before = parseInt(process.argv[3] || "2000", 10);
const after = parseInt(process.argv[4] || "2000", 10);
console.log(src.slice(Math.max(0, offset - before), Math.min(src.length, offset + after)));