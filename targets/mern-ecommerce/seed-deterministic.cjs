// Preloaded into the app's seed script (node --require) so that faker produces
// the same products, brands and categories on every reset.
// faker is resolved from the working directory (the app's server folder), so the
// seed script and this file share one faker instance.
const fakerPath = require.resolve('@faker-js/faker', { paths: [process.cwd()] });
require(fakerPath).faker.seed(42);
