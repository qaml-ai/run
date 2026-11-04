export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'typebox' || specifier.startsWith('typebox/')) {
    return nextResolve(specifier, { ...context, parentURL: new URL('../package.json', import.meta.url).href });
  }
  return nextResolve(specifier, context);
}
