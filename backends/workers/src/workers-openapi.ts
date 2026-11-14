import { isVolumePath, VOLUMES_GONE } from "./files.ts";

const methods = ["get", "head", "post", "put", "patch", "delete", "options"];
const gone = {
  summary: "Retired volume endpoint",
  security: [],
  responses: {
    "410": {
      description: VOLUMES_GONE,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["error", "code"],
            properties: { error: { const: VOLUMES_GONE }, code: { const: "gone" } },
          },
        },
      },
    },
  },
};

export function workersOpenApi<T extends { paths: Record<string, unknown> }>(source: T) {
  const paths = Object.fromEntries(Object.entries(source.paths).filter(([path]) => !isVolumePath(path)));
  const operations = Object.fromEntries(methods.map(method => [method, gone]));
  paths["/v1/volumes"] = operations;
  paths["/v1/volumes/{path}"] = {
    description: "Applies to every path under /v1/volumes, including nested paths.",
    parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }],
    ...operations,
  };
  return { ...source, paths };
}
