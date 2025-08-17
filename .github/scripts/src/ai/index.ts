import type { getOctokit } from "@actions/github";
import type { context as ContextType } from "@actions/github";
import * as core_ from "@actions/core";
import { components } from "@octokit/openapi-webhooks-types";
import { formatDiffHunk } from "./diff";

import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";

type GitHub = ReturnType<typeof getOctokit>;
type Core = typeof core_;
type Context = typeof ContextType;
type ReviewCommentCreated =
  components["schemas"]["webhook-pull-request-review-comment-created"];
type Comment = ReviewCommentCreated["comment"];
type AuthorAssociation = Comment["author_association"];

function createSystemMessage(
  code: string,
  file: string
): ChatCompletionMessageParam {
  console.log(code);
  return {
    role: "system",
    content: `
You are a helpful assistant for GitHub PR reviews. Your task is to reply to questions/requests on the following code changes.

# Code Changes

${file}:
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

const COMMAND_PREFIX_REGEX = /^!ai\s+/;
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
      .replace(COMMAND_PREFIX_REGEX, "")
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

function validateCommentAuthor(
  user: string,
  authorAssociation: AuthorAssociation
): void {
  if (
    !["collaborator", "maintainer", "owner"].includes(
      authorAssociation.toLowerCase()
    )
  ) {
    throw new Error(
      `User ${user} does not have permission to use this command. Only collaborators, maintainers, and owners can use this command.`
    );
  }
}

async function reply({
  github,
  context,
  body,
}: {
  github: GitHub;
  context: Context;
  body: string;
}) {
  const payload = context.payload as ReviewCommentCreated;
  const { repo, owner } = context.repo;
  const {
    comment: { commit_id, path, id: comment_id },
    pull_request: { number: pull_number },
  } = payload;
  await github.rest.pulls.createReviewComment({
    repo,
    owner,
    pull_number,
    body,
    commit_id,
    path,
    in_reply_to: comment_id,
  });
}

async function run({
  github,
  context,
}: {
  github: GitHub;
  context: Context;
}): Promise<void> {
  const payload = context.payload as ReviewCommentCreated;
  const { repo, owner } = context.repo;
  const { comment } = payload;

  // Ignore comments not starting with `!ai`
  if (!COMMAND_PREFIX_REGEX.test(comment.body)) {
    return;
  }

  const { path, id: comment_id } = comment;
  await github.rest.reactions.createForPullRequestReviewComment({
    owner,
    repo,
    comment_id,
    content: "eyes",
  });

  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_API_BASE;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }
  if (!baseUrl) {
    throw new Error("OPENAI_API_BASE environment variable is not set");
  }

  const { user, author_association } = comment;
  validateCommentAuthor(user?.login || "", author_association);

  const systemMessage = createSystemMessage(
    formatDiffHunk(comment.diff_hunk) || "",
    path
  );
  const messages = await generateMessages(github, owner, repo, comment);
  const body = await chatCompletions({
    apiKey,
    baseUrl,
    messages: [systemMessage, ...messages],
  });
  await reply({
    github,
    context,
    body,
  });
}

export async function ai({
  github,
  context,
  core,
}: {
  github: GitHub;
  context: Context;
  core: Core;
}): Promise<void> {
  try {
    await run({ github, context });
  } catch (error) {
    if (error instanceof Error) {
      const {
        runId,
        repo: { repo, owner },
      } = context;
      const workflowRunUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
      const body = [
        "An error occurred while processing your request:",
        error.message,
        `[View Workflow](${workflowRunUrl})`,
      ].join("\n\n");
      await reply({
        github,
        context,
        body,
      });
      core.setFailed(error.message);
    }
  }
}
