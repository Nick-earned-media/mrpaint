module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("assets");
  eleventyConfig.addPassthroughCopy({ "public": "/" });

  eleventyConfig.addCollection("posts", (api) =>
    api.getFilteredByGlob("blog/*.md").sort((a, b) => b.date - a.date)
  );

  eleventyConfig.addFilter("isoDate", (d) =>
    d instanceof Date ? d.toISOString().slice(0, 10) : d
  );

  eleventyConfig.addFilter("countBy", (arr, key, value) =>
    Array.isArray(arr) ? arr.filter((it) => it && it[key] === value).length : 0
  );

  return {
    dir: {
      input: ".",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
};
