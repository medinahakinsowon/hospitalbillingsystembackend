// Makes a schema insert-only at the application level. For real protection also give the
// production database user insert-only rights on these collections (see README).
const BLOCKED = [
  'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete',
];
export function appendOnly(schema, name) {
  for (const op of BLOCKED) {
    schema.pre(op, function () {
      throw new Error(`${name} is append-only: ${op} is not allowed`);
    });
  }
  schema.pre('save', function () {
    if (!this.isNew) throw new Error(`${name} is append-only: existing records cannot be modified`);
  });
}
