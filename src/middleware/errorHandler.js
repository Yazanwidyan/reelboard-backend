import { HttpError } from "../lib/errors.js";

export const notFoundHandler = (req, res) => {
  res.status(404).json({ error: { message: `No route for ${req.method} ${req.path}` } });
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }
  // Malformed JSON body from express.json().
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: { message: "Malformed JSON body" } });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: { message: "Request body too large" } });
  }
  console.error(err);
  res.status(500).json({ error: { message: "Something went wrong" } });
};
