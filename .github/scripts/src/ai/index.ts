import type { getOctokit } from "@actions/github";
import type { context as ContextType } from "@actions/github";
import * as core_ from "@actions/core";
import { components } from "@octokit/openapi-webhooks-types";
import { formatDiffHunk } from "./diff";
import OpenAI from "openai";
import {
  ChatCompletionMessageParam,
  ChatCompletion,
} from "openai/resources/chat/completions";

type GitHub = ReturnType<typeof getOctokit>;
type Core = typeof core_;
type Context = typeof ContextType;
type ReviewCommentCreated =
  components["schemas"]["webhook-pull-request-review-comment-created"];
type ReviewComment = Awaited<
  ReturnType<GitHub["rest"]["pulls"]["getReviewComment"]>
>["data"];
type AuthorAssociation = ReviewComment["author_association"];

function createSystemMessage(
  code: string,
  file: string
): ChatCompletionMessageParam {
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
}): Promise<ChatCompletion> {
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
  });
  return await client.chat.completions.create({
    model: "openai/gpt-5-mini",
    messages,
  });
}

const COMMAND_PREFIX_REGEX = /^!ai\s+/;
const AI_RESPONSE_MARKER = "<!-- AI_RESPONSE -->";

function commentToMessage({
  user,
  body,
}: ReviewComment): ChatCompletionMessageParam {
  let role: "user" | "assistant";
  let prefix: string;
  if (body.includes(AI_RESPONSE_MARKER)) {
    role = "assistant";
    prefix = "";
  } else {
    role = "user";
    prefix = `(${user.login}): `;
  }
  const content =
    prefix +
    body
      .replace(COMMAND_PREFIX_REGEX, "")
      .replace(AI_RESPONSE_MARKER, "")
      .replace(/<details>[\s\S]*?<\/details>/g, "")
      .trim();

  return {
    role,
    content,
  };
}

async function fetchReplies({
  github,
  owner,
  repo,
  pull_number,
  in_reply_to_id,
}: {
  github: GitHub;
  owner: string;
  repo: string;
  pull_number: number;
  in_reply_to_id: number;
}): Promise<ReviewComment[]> {
  const comments = await github.paginate(github.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number,
  });
  return comments.filter(c => c.in_reply_to_id === in_reply_to_id);
}

async function generateMessages(
  github: GitHub,
  context: Context,
  comment: ReviewComment
): Promise<ChatCompletionMessageParam[]> {
  const { owner, repo } = context.repo;
  const payload = context.payload as ReviewCommentCreated;
  const pull_number = payload.pull_request.number;
  const comments: ReviewComment[] = [];
  if (comment.in_reply_to_id) {
    // Fetch replies in the same thread
    const replies = await fetchReplies({
      github,
      owner,
      repo,
      pull_number,
      in_reply_to_id: comment.in_reply_to_id,
    });
    comments.push(...replies);

    // Fetch the root comment
    const { data: rootComment } = await github.rest.pulls.getReviewComment({
      owner,
      repo,
      pull_number,
      comment_id: comment.in_reply_to_id,
    });

    comments.push(rootComment);
  } else {
    comments.push(comment);
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
  if (!["COLLABORATOR", "MAINTAINER", "OWNER"].includes(authorAssociation)) {
    throw new Error(
      `User ${user} does not have permission to use this command. Only collaborators, maintainers, and owners can use this command.`
    );
  }
}

async function postReplyComment({
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

function getWorkflowRunUrl(context: Context): string {
  const {
    runId,
    repo: { repo, owner },
  } = context;
  return `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
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
  const { data: comment } = await github.rest.pulls.getReviewComment({
    owner,
    repo,
    comment_id: payload.comment.id,
  });

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
  validateCommentAuthor(user.login, author_association);

  const systemMessage = createSystemMessage(
    formatDiffHunk(comment.diff_hunk) || "",
    path
  );
  const messages = await generateMessages(github, context, comment);
  const response = await chatCompletions({
    apiKey,
    baseUrl,
    messages: [systemMessage, ...messages],
  });
  const details = `
<details><summary>Details</summary>

### Workflow run:

${getWorkflowRunUrl(context)}

### Usage:

\`\`\`json
${JSON.stringify(response.usage, null, 2)}
\`\`\`

</details>
`;
  const reply = response.choices[0].message.content || "";
  const body = `@${user.login} ${reply}\n\n${details}`;
  await postReplyComment({
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
      const body = [
        "An error occurred while processing your request:",
        error.message,
        `[View Workflow](${getWorkflowRunUrl(context)})`,
      ].join("\n\n");
      await postReplyComment({
        github,
        context,
        body,
      });
      core.setFailed(error.message);
    }
  }
}
