import { z } from 'zod';

const sha40 = z.string().regex(/^[a-f0-9]{40}$/);

export const githubEnvelopeSchema = z.object({
  errors: z.array(z.unknown()).optional(),
}).passthrough();

export const repositorySchema = z.object({
  id: z.union([z.number(), z.string()]),
  full_name: z.string(),
  default_branch: z.string(),
  archived: z.boolean(),
  fork: z.boolean(),
});

export const checkRunSchema = z.object({
  app: z.object({ id: z.number() }).passthrough(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string(),
  head_sha: sha40,
  pull_requests: z.array(z.object({ number: z.number() })),
});

export const pullSchema = z.object({
  state: z.string(),
  draft: z.boolean(),
  user: z.object({ type: z.string() }),
  head: z.object({
    repo: z.object({ full_name: z.string(), id: z.union([z.number(), z.string()]) }),
    ref: z.string(),
    sha: sha40,
  }),
  base: z.object({
    repo: z.object({ full_name: z.string(), id: z.union([z.number(), z.string()]) }),
    ref: z.string(),
  }),
});

export const commitSchema = z.object({
  tree: z.object({ sha: sha40 }),
});

export const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({
    path: z.string(),
    type: z.string(),
    mode: z.string().optional(),
    size: z.number().optional(),
    sha: sha40.optional(),
  })),
});

export const blobSchema = z.object({
  encoding: z.literal('base64'),
  content: z.string(),
});

export const gitRefSchema = z.object({
  object: z.object({ sha: sha40 }),
});

export const gitRefCreateSchema = z.object({}).passthrough();

export const gitTreeCreateSchema = z.object({
  sha: sha40,
});

export const gitCommitCreateSchema = z.object({
  sha: sha40,
});

export const pullCreateSchema = z.object({
  number: z.number(),
  html_url: z.string(),
});

export const graphqlBodySchema = z.object({
  data: z.unknown(),
});

export const sourcePrefixesSchema = z.array(
  z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/)
    .refine((path) => path.split('/').filter(Boolean).every((part) => !part.startsWith('.')), 'Invalid source scope.')
    .refine((path) => !path.includes('//'), 'Invalid source scope.'),
).max(8);
