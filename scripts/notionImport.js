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
    `---\n${frontmatter}---\n\n${content.markdown}`,
    (err) => {
      if (err) {
        throw err;
      }
    }
  );
};


const loadProjects = async () => {
  await deleteFiles("projekte");

  const response = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID_PROJECTS
  });

  for (const page of response.results) {
    const props = page.properties;
    const project = {};

    project["title"] = props.Name.title[0].plain_text;
    project["publishDate"] = props.Publikation.date?.start;
    project["expiryDate"] = props.Publikation.date?.end ?? undefined;
    project["summary"] = props.Zusammenfassung.rich_text[0].plain_text;
    project["tags"] = props.Tags.multi_select.map((tag) => tag.name);
    project["categories"] = props.Leistungsnamen.rollup?.array.map((category) => category.title[0].plain_text);
    project["author"] = props.Autor.people[0].name;
    project["authorAvatar"] = props.Autor.people[0].avatar_url;

    project["date"] = page.created_time;
    project["lastmod"] = page.last_edited_time;
    project["notionUrl"] = page.url;

    if (!project["publishDate"]) {
      continue;
    }

    if (page.cover?.type == "external") {
      project["image"] = await download(page.cover.external.url, "images/projects");
    } else if (page.cover?.type == "file") {
      project["image"] = await download(page.cover.file.url, "images/projects");
    }

    const mdblocks = await n2m.pageToMarkdown(page.id);
    project["markdown"] = n2m.toMarkdownString(mdblocks).parent;

    writeContent(project, `content/german/projekte/${project["title"]}.md`);
  }
};

const loadServices = async () => {
  await deleteFiles("leistungen");

  const response = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID_SERVICES,
  });

  for (const page of response.results) {
    const props = page.properties;
    const service = {};

    service["title"] = props.Name.title[0].plain_text;
    service["date"] = page.created_time;
    service["lastmod"] = page.last_edited_time;
    service["notionUrl"] = page.url;
    service["tags"] = props.Tags.multi_select.map((tag) => tag.name);

    if (page.cover?.type == "external") {
      service["image"] = await download(page.cover.external.url, "images/services");
    } else if (page.cover?.type == "file") {
      service["image"] = await download(page.cover.file.url, "images/services");
    }

    const mdblocks = await n2m.pageToMarkdown(page.id);
    service["markdown"] = n2m.toMarkdownString(mdblocks).parent;

    writeContent(service, `content/german/leistungen/${service["title"]}.md`);
  }
}

const loadTestimonials = async () => {
  const { results } = await notion.blocks.children.list({
    block_id: process.env.NOTION_BLOCK_ID_TESTIMONIALS,
  });

  const md = {
    enable: true,
    _build: {
      render: "never"
    }
  };

  for (const block of results) {
    if (block.type.startsWith("heading")) {
      md["title"] = block[block.type].rich_text[0].plain_text;
    } else if (block.type.startsWith("paragraph")) {
      md["description"] = block[block.type].rich_text[0].plain_text;
    } else if (block.type === "child_database") {
      const response = await notion.databases.query({
        database_id: process.env.NOTION_DATABASE_ID_TESTIMONIALS,
      });

      md["testimonials"] = [];

      for (const testimonial of response.results) {
        const contact = await notion.pages.retrieve({
          page_id: testimonial.properties.Kontakt.relation[0].id });
        
        md["testimonials"].push({
          name: contact.properties.Name.title[0].plain_text,
          designation: testimonial.properties.Position.title[0].plain_text,
          avatar: await download(contact.icon.file.url, "images/testimonials"),
          content: await n2m.pageToMarkdown(testimonial.id)
            .then((blocks) => n2m.toMarkdownString(blocks).parent.trim())
        });
      };

      md["testimonials"].reverse();
    } else {
      throw new Error(`Unknown block type: ${block.type}`);
    }
  }

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
  console.log("Loading Projects...");
  await loadProjects();

  console.log("Loading Services...");
  await loadServices();

  console.log("Loading Testimonials...");
  await loadTestimonials();

  console.log("Deleting unused images...");
  await deleteUnusedImages();
})();
