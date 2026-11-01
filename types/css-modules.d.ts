// Bun bundles `*.module.css` imports as class-name maps (the skill-hub panel
// styles); this declaration gives tsc the same view of the import.
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
