import { badRequest } from "../lib/errors.js";

// Parses req[source] with a zod schema and replaces it with the parsed
// (coerced, defaulted, stripped) value — handlers only ever see clean input.
// Express 5 makes req.query a getter, so parsed query lands on req.validQuery.
export const validate = (schema, source = "body") => (req, res, next) => {
  const result = schema.safeParse(req[source] ?? {});
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    return next(badRequest("Invalid request", details));
  }
  if (source === "query") req.validQuery = result.data;
  else req[source] = result.data;
  next();
};

export default validate;
