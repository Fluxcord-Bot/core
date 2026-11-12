import { normalizeMessage } from "./UnifiedMessage.js";
import { handleCreate } from "./create.js";
import { handleEdit } from "./edit.js";
import { handleDelete, handleBulkDelete } from "./delete.js";

const ctxHolder = { discordClient: null, defaultFluxerClient: null };

export function setPipelineCtx(partial) {
  Object.assign(ctxHolder, partial);
}

function withCtx(message, options) {
  const umsg = normalizeMessage(message, options);
  if (!umsg) {
    throw new Error(`normalizeMessage: unsupported message object (platform unknown)`);
  }
  umsg.ctx = ctxHolder;
  return umsg;
}

export async function pipelineCreate(message, options = {}) {
  await handleCreate(withCtx(message, options), options);
}

export async function pipelineEdit(message, options = {}) {
  await handleEdit(withCtx(message, options));
}

export async function pipelineDelete(message, options = {}) {
  await handleDelete(withCtx(message, options));
}

export async function pipelineBulkDelete(ref, messageIds) {
  await handleBulkDelete(ref.platform, ref.channelId, messageIds, ctxHolder);
}

export async function pipelineDestroyEndpoints(ref) {
  return destroyEndpointsWithCtx(ref, ctxHolder);
}

async function destroyEndpointsWithCtx(ref, ctx) {
  const { destroyEndpoints } = await import("./delete.js");
  return destroyEndpoints(ref, ctx);
}
