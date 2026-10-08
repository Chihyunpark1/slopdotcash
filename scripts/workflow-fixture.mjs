/** Parse actual workflow structure for release tests, without matching comments. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pythonCommand } from "./skill-python.mjs";

export function workflow(path) {
  const { executable, prefix } = pythonCommand(process.cwd());
  return JSON.parse(
    execFileSync(
      executable,
      [
        ...prefix,
        "-c",
        "import yaml,json,sys; value=yaml.safe_load(sys.stdin); value['on']=value.pop(True,value.get('on')); print(json.dumps(value))",
      ],
      { input: readFileSync(path, "utf8"), encoding: "utf8" },
    ),
  );
}
