import dotenv from "dotenv";
import path from "path";

dotenv.config();

export const PORT = Number(process.env.PORT || 4000);
export const PACKAGES_DIR = process.env.PACKAGES_DIR
  ? path.resolve(process.env.PACKAGES_DIR)
  : path.resolve(process.cwd(), "packages");
