// Changes every build — used to cache-bust /assets/css/style.css, which is
// served with an immutable 1-year cache header (see vercel.json).
module.exports = () => Date.now().toString(36);
