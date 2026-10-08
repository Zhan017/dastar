/**
 * Package boundaries (system design, section 5): the domain at the bottom, the engine on it, the worker and
 * the reference API on the engine, the harness on all of them. Source only; tests may reach into helpers.
 */
const pkg = (name) => `^(packages|apps)/${name}/src/`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-is-pure",
      comment: "@dastar/core has no database and no other workspace package below it",
      severity: "error",
      from: { path: pkg("core") },
      to: { path: ["^(packages|apps)/(db|worker|api|harness)/", "node_modules/(pg|pg-[^/]+)/"] },
    },
    {
      name: "engine-knows-no-hosts",
      comment: "@dastar/db is embedded by hosts; it never imports the worker, the reference API, or the harness",
      severity: "error",
      from: { path: pkg("db") },
      to: { path: "^(packages|apps)/(worker|api|harness)/" },
    },
    {
      name: "worker-on-the-engine-only",
      severity: "error",
      from: { path: pkg("worker") },
      to: { path: "^(packages|apps)/(api|harness)/" },
    },
    {
      name: "api-on-the-engine-only",
      severity: "error",
      from: { path: pkg("api") },
      to: { path: "^(packages|apps)/(worker|harness)/" },
    },
    {
      name: "no-unresolvable",
      comment: "an import that does not resolve would slip past every rule above, so it is an error itself",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-undeclared-dependencies",
      comment: "a package imports only what its package.json declares",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-reaching-into-tests",
      comment: "source never imports test code",
      severity: "error",
      from: { path: "^(packages|apps)/[^/]+/src/" },
      to: { path: "^(packages|apps)/[^/]+/test/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
