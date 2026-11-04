// Font and image files are bundled as Data modules (wrangler.toml [[rules]]; vitest.config.ts does the same for tests): the import is the file's bytes.
declare module "*.woff2" {
  const data: ArrayBuffer;
  export default data;
}
declare module "*.webp" {
  const data: ArrayBuffer;
  export default data;
}
declare module "*.png" {
  const data: ArrayBuffer;
  export default data;
}
