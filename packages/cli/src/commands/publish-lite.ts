import { Agent } from "@atproto/api"
import {  BlogPost } from "../lib/types"

const LEXICON = "space.litenote.note"
const MAX_CONTENT = 10000

export async function createNote(
  agent: Agent,
  post: BlogPost,
  atUri: string,
): Promise<void> {
  // Parse the atUri to get the site.standard.document rkey
  // Format: at://did:plc:xxx/collection/rkey
  const uriMatch = atUri.match(/^at:\/\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!uriMatch) {
    throw new Error(`Invalid atUri format: ${atUri}`);
  }

  const [, , , rkey] = uriMatch;
  const publishDate = new Date(post.frontmatter.publishDate).toISOString();

  const record: Record<string, unknown> = {
    $type: LEXICON,
    title: post.frontmatter.title,
    content: post.content.slice(0, MAX_CONTENT),
    createdAt: publishDate,
    publishedAt: publishDate,
  };


  const response = await agent.com.atproto.repo.createRecord({
    repo: agent.did!,
    collection: LEXICON,
    record,
    rkey,
    validate: false
  });

  console.log("\n\n create -", response);
}

export async function updateNote(
  agent: Agent,
  post: BlogPost,
  atUri: string,
): Promise<void> {
  // Parse the atUri to get the rkey
  // Format: at://did:plc:xxx/collection/rkey
  const uriMatch = atUri.match(/^at:\/\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!uriMatch) {
    throw new Error(`Invalid atUri format: ${atUri}`);
  }

  const [, , , rkey] = uriMatch;

  const publishDate = new Date(post.frontmatter.publishDate).toISOString();

  const record: Record<string, unknown> = {
    $type: LEXICON,
    title: post.frontmatter.title,
    content: post.content.slice(0, MAX_CONTENT),
    createdAt: publishDate,
    publishedAt: publishDate,
  };

  const response = await agent.com.atproto.repo.putRecord({
    repo: agent.did!,
    collection: LEXICON,
    rkey: rkey!,
    record,
    validate: false
  });

  console.log("\n\n update -", response);
}
