import fs from "node:fs";
import { parseWithRaw, readModelUid, readSortName } from "./src/proxy/handlers/userstatus-shape.js";

function readStr(parsed, fieldNum) {
    for (const f of parsed.fields) {
        if (f.field === fieldNum && f.wireType === 2 && f.value) return f.value.toString("utf8");
    }
    return null;
}

const file = process.argv[2];
const buf = fs.readFileSync(file);
const top = parseWithRaw(buf);
const f1 = top.fields.find((f) => f.field === 1 && f.wireType === 2);
const cmcd = parseWithRaw(f1.value);
const f33 = cmcd.fields.find((f) => f.field === 33 && f.wireType === 2);
const data = parseWithRaw(f33.value);

let modelCount = 0;
const byokModels = [];
for (const f of data.fields) {
    if (f.field === 1 && f.wireType === 2) {
        modelCount++;
        const uid = readModelUid(f.value);
        if (uid && uid.includes("BYOK")) byokModels.push(uid);
    }
}
console.log("模型数组条目总数:", modelCount);
console.log("BYOK 条目:", byokModels.length ? byokModels.join(", ") : "(无)");

for (const f of data.fields) {
    if (f.field === 2 && f.wireType === 2) {
        const sort = parseWithRaw(f.value);
        const name = readSortName(f.value);
        const sortFieldSummary = sort.fields.map((x) => "f" + x.field).join(",");
        console.log("\n=== sort name=" + name + " sortFields=[" + sortFieldSummary + "] ===");
        for (const g of sort.fields) {
            if (g.field === 2 && g.wireType === 2) {
                const group = parseWithRaw(g.value);
                const groupName = readStr(group, 1);
                const fieldSummary = group.fields.map((x) => "f" + x.field + (x.wireType === 2 ? "(" + x.value.length + "b)" : "=v" + x.value)).join(",");
                const labels = [];
                const others = {};
                for (const x of group.fields) {
                    if (x.field === 2 && x.wireType === 2) labels.push(x.value.toString("utf8"));
                    else if (x.wireType === 2) (others["f" + x.field] = others["f" + x.field] || []).push(x.value.toString("utf8").slice(0, 60));
                    else (others["f" + x.field] = others["f" + x.field] || []).push(String(x.value));
                }
                console.log("  group=" + JSON.stringify(groupName) + " fields=[" + fieldSummary + "] labels(" + labels.length + ")");
                if (labels.length <= 10) labels.forEach((l) => console.log("      label: " + l));
                else console.log("      labels 示例: " + labels.slice(0, 5).join(" | ") + " ...");
                for (const [k, v] of Object.entries(others)) {
                    console.log("      " + k + "(" + v.length + "): " + v.slice(0, 6).join(" | "));
                }
            }
        }
    }
}