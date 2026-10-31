// validate({ params, query, body }) with Zod schemas. Parsed (coerced) values replace the originals.
export const validate = (schemas) => (req, res, next) => {
  try {
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part]);
      if (!result.success) throw result.error;
      if (part === 'query') {
        Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
      } else {
        req[part] = result.data;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
};
