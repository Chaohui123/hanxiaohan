import { getIamToken } from "./iam.js";

const token = await getIamToken({ keyFile: process.argv[2] });
process.stdout.write(token);
