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

const writeContent = (content, section) => {
  const path = `content/german/${section}/${content.title}.md`;
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
  const response = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID_PROJECTS,
  });

  for (const page of response.results) {
    const props = page.properties;
    const project = {};
    
    project["title"] = props.Name.title[0].plain_text;
    project["publishDate"] = props.Publikation.date?.start;
    project["expiryDate"] = props.Publikation.date?.end ?? undefined;
    project["summary"] = props.Zusammenfassung.rich_text[0].plain_text;
    project["tags"] = props.Tags.multi_select.map((tag) => tag.name);
    project["author"] = {
      name: props.Autor.people[0].name,
      avatar: props.Autor.people[0].avatar_url
    };

    project["date"] = page.created_time;
    project["lastmod"] = page.last_edited_time;
    project["notionUrl"] = page.url;

    if (!project["publishDate"]) {
      continue;
    }

    if (page.cover?.type == "external") {
      project["images"] = [await download(page.cover.external.url, "images")];
    } else if (page.cover?.type == "file") {
      project["images"] = [await download(page.cover.file.url, "images")];
    } else {
      project["images"] = [];
    }

    const mdblocks = await n2m.pageToMarkdown(page.id);
    project["markdown"] = n2m.toMarkdownString(mdblocks).parent;

    writeContent(project, "projekte");
  }
};

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

const deleteProjectFiles = async () => {
  const path = "content/german/projekte";
  const files = readdirSync("content/german/projekte");

  files.forEach((file) => {
    if (file !== "_index.md" && file.endsWith(".md")) {
      unlinkSync(join(path, file));
    }
  });
};

(async () => {
  await deleteProjectFiles();
  await loadProjects();
  await deleteUnusedImages();
})();
