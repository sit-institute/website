require("dotenv").config();

const { Client } = require("@notionhq/client");
const { NotionToMarkdown } = require("notion-to-md");
const { Downloader } = require("nodejs-file-downloader");
const { existsSync, writeFile, readFileSync, readdirSync, unlinkSync } = require("fs");
const { join } = require("path");
const YAML = require('yaml');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

const previousImages = JSON.parse(readFileSync("notion-images.json", "utf8"));
const currentImages = [];

const download = async (url, path) => {
  const fileName = url.split('?')[0].split('/').pop();
  const filePath = `assets/${path}/${fileName}`;

  if (!/\.[a-zA-Z0-9]+$/.test(fileName)) {
    throw new Error(`The file at ${url} does not have an extension.`);
  }

  currentImages.push(filePath);

  if (existsSync(filePath)) {
    return `${path}/${fileName}`;
  }

  const downloader = new Downloader({
    url: url,
    directory: `assets/${path}`,
  });

  return (await downloader.download()).filePath.replace("assets/", "");
}

n2m.setCustomTransformer("image", async (block) => {
  const { image } = block;
  
  if (image.type == "external") {
    return `![${image.caption}](${image.external.url})`;
  } else if (image.type == "file") {
    return `![${image.caption}](${(await download(image.file.url, "images")).replace("assets/", "")})`;
  }
});

const writeContent = (content, path) => {
  const frontmatter = YAML.stringify({
    ...content,
    markdown: undefined,
    include_footer: true
  });

  writeFile(path,
    `---\n${frontmatter}---\n\n${content.markdown ?? ""}`,
    (err) => {
      if (err) {
        throw err;
      }
    }
  );
};


const loadCaseStudies = async () => {
  await deleteFiles("case-studies");

  const response = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID_CASE_STUDIES,
  });

  for (const page of response.results) {
    const props = page.properties;
    const caseStudy = {};

    caseStudy["title"] = props.Name.title[0].plain_text;
    console.log(`- ${caseStudy["title"]}`);

    caseStudy["publishDate"] = props.Publikation.date?.start;
    caseStudy["expiryDate"] = props.Publikation.date?.end ?? undefined;
    caseStudy["summary"] = props.Zusammenfassung.rich_text[0].plain_text;
    caseStudy["website"] = props.Webseite.url;
    caseStudy["tags"] = props.Tags.multi_select.map((tag) => tag.name);
    caseStudy["categories"] = props.Kompetenznamen.rollup?.array.map((category) => category.title[0].plain_text);
    caseStudy["author"] = props.Autor.people[0].name;

    caseStudy["authorAvatar"] = await download(props.Autor.people[0].avatar_url, "images/authors");

    caseStudy["date"] = page.created_time;
    caseStudy["lastmod"] = page.last_edited_time;
    caseStudy["notionUrl"] = page.url;
    caseStudy["notionId"] = page.id;

    if (!caseStudy["publishDate"]) {
      continue;
    }

    if (page.cover?.type == "external") {
      caseStudy["image"] = await download(page.cover.external.url, "images/case-studies");
    } else if (page.cover?.type == "file") {
      caseStudy["image"] = await download(page.cover.file.url, "images/case-studies");
    }

    caseStudy["gallery"] = [];
    for (const image of page.properties.Bilder.files) {
      if (image.type == "external") {
        // error prone
      } else if (image.type == "file") {
        caseStudy["gallery"].push(await download(image.file.url,
          `images/case-studies/${caseStudy["notionId"]}`));
      }
    }

    const mdblocks = await n2m.pageToMarkdown(page.id);
    caseStudy["markdown"] = n2m.toMarkdownString(mdblocks).parent;

    writeContent(caseStudy, `content/german/case-studies/${caseStudy["title"]}.md`);
  }
};

const loadCompetencies = async () => {
  await deleteFiles("kompetenzen");

  const response = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID_COMPETENCIES,
  });

  for (const page of response.results) {
    const props = page.properties;
    const competency = {};

    competency["title"] = props.Name.title[0].plain_text;
    console.log(`- ${competency["title"]}`);

    competency["date"] = page.created_time;
    competency["lastmod"] = page.last_edited_time;
    competency["notionUrl"] = page.url;
    competency["tags"] = props.Tags.multi_select.map((tag) => tag.name);
    competency["summary"] = props.Zusammenfassung.rich_text[0].plain_text;

    if (page.cover?.type == "external") {
      competency["image"] = await download(page.cover.external.url, "images/competencies");
    } else if (page.cover?.type == "file") {
      competency["image"] = await download(page.cover.file.url, "images/competencies");
    }

    const mdblocks = await n2m.pageToMarkdown(page.id);
    competency["markdown"] = n2m.toMarkdownString(mdblocks).parent;

    writeContent(competency, `content/german/kompetenzen/${competency["title"]}.md`);
  }
}

const loadTestimonials = async () => {
  const { results } = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID_TESTIMONIALS,
  });

  const md = {
    enable: true,
    _build: {
      render: "never"
    }
  };

  md["testimonials"] = [];

  for (const testimonial of results) {
    const contact = await notion.pages.retrieve({
      page_id: testimonial.properties.Kontakt.relation[0].id });
    
    console.log(`- ${contact.properties.Name.title[0].plain_text}`);

    md["testimonials"].push({
      name: contact.properties.Name.title[0].plain_text,
      designation: testimonial.properties.Position.title[0].plain_text,
      avatar: await download(contact.icon.file.url, "images/testimonials"),
      content: await n2m.pageToMarkdown(testimonial.id)
        .then((blocks) => n2m.toMarkdownString(blocks).parent.trim())
    });
  };

  md["testimonials"].reverse();

  writeContent(md, `content/german/sections/testimonial.md`);
}

const deleteUnusedImages = async () => {
  previousImages.forEach((imagePath) => {
    if (!currentImages.includes(imagePath)) {
      if (existsSync(imagePath)) {
        unlinkSync(imagePath);
      }
    }
  });

  writeFile("notion-images.json", JSON.stringify(currentImages, null, 2), (err) => {
    if (err) {
      throw err;
    }
  });
};

const deleteFiles = async (section) => {
  const path = `content/german/${section}`;
  const files = readdirSync(path);

  files.forEach((file) => {
    if (file !== "_index.md" && file.endsWith(".md")) {
      unlinkSync(join(path, file));
    }
  });
};

(async () => {
  console.log("Loading Case-Studies...");
  await loadCaseStudies();

  console.log("Loading Competencies...");
  await loadCompetencies();

  console.log("Loading Testimonials...");
  await loadTestimonials();

  console.log("Deleting unused images...");
  await deleteUnusedImages();
})();
