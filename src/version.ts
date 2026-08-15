import pkg from "../package.json" with { type: "json" };

export const NAME: string = pkg.name;
export const VERSION: string = pkg.version;
