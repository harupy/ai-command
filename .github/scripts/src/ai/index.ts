import type { getOctokit } from "@actions/github";
import type { context as ContextType } from "@actions/github";
import { components } from "@octokit/openapi-webhooks-types";
import { formatDiffHunk } from "./diff";

import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";

type GitHub = ReturnType<typeof getOctokit>;
type Context = typeof ContextType;
type Comment =
  components["schemas"]["webhook-pull-request-review-comment-created"]["comment"];

function createSystemMessage(code: string): ChatCompletionMessageParam {
  console.log(code);
  return {
    role: "system",
    content: `
You are a helpful assistant for GitHub PR reviews. Your task is to reply to questions/requests on the following code changes.

# Code Changes
${code}
`,
  };
}

async function chatCompletions({
  apiKey,
  baseUrl,
  messages,
}: {
  apiKey: string;
  baseUrl: string;
  messages: ChatCompletionMessageParam[];
}): Promise<string> {
  console.log(messages);
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
  });
  const response = await client.chat.completions.create({
    model: "openai/gpt-5-mini",
    messages,
  });
  return response.choices[0].message.content || "";
}

const AI_RESPONSE_MARKER = "<!-- AI_RESPONSE -->";

function commentToMessage({
  login,
  body,
}: SimpleComment): ChatCompletionMessageParam {
  let role: "user" | "assistant";
  let prefix: string;
  if (body.includes(AI_RESPONSE_MARKER)) {
    role = "assistant";
    prefix = "";
  } else {
    role = "user";
    prefix = `(${login}): `;
  }
  const content =
    prefix +
    body
      .replace(/^!ai\s+/, "")
      .replace(AI_RESPONSE_MARKER, "")
      .trim();

  return {
    role,
    content,
  };
}

type SimpleComment = {
  login: string;
  body: string;
  created_at: string;
};

async function fetchPastComments(
  github: GitHub,
  owner: string,
  repo: string,
  in_reply_to_id?: number
): Promise<SimpleComment[]> {
  if (!in_reply_to_id) return [];
  const { data } = await github.rest.pulls.getReviewComment({
    owner,
    repo,
    comment_id: in_reply_to_id,
  });
  const {
    user: { login },
    body,
    created_at,
  } = data;
  const next = await fetchPastComments(
    github,
    owner,
    repo,
    data.in_reply_to_id
  );
  return [{ login, body, created_at }, ...next];
}

async function generateMessages(
  github: GitHub,
  owner: string,
  repo: string,
  comment: Comment
): Promise<ChatCompletionMessageParam[]> {
  const comments = await fetchPastComments(
    github,
    owner,
    repo,
    comment.in_reply_to_id
  );
  if (comment.user) {
    comments.push({
      login: comment.user.login,
      body: comment.body,
      created_at: comment.created_at,
    });
  }

  comments.sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  return comments.map(commentToMessage);
}

export async function ai({
  github,
  context,
}: {
  github: GitHub;
  context: Context;
}): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_API_BASE;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }

  if (!baseUrl) {
    throw new Error("OPENAI_API_BASE environment variable is not set");
  }

  const payload = context.payload.comment as Comment;
  console.log(payload);
  const { user, author_association } = payload;
  if (!user) {
    return;
  }

  if (
    !["collaborator", "maintainer", "owner"].includes(
      author_association.toLowerCase()
    )
  ) {
    throw new Error(
      `${user.login} does not have permission to use this command`
    );
  }

  const { repo, owner } = context.repo;
  const pull_number = context.payload.pull_request?.number || 0;
  const { commit_id, path, id: comment_id } = payload;
  const systemMessage = createSystemMessage(
    formatDiffHunk(payload.diff_hunk) || ""
  );
  const messages = await generateMessages(github, owner, repo, payload);
  const answer = await chatCompletions({
    apiKey,
    baseUrl,
    messages: [systemMessage, ...messages],
  });
  console.log("AI Response:", answer);

  await github.rest.pulls.createReviewComment({
    repo,
    owner,
    pull_number,
    body: answer,
    commit_id,
    path,
    in_reply_to: comment_id,
  });
}
