function saveParams(modelId, postId) {
  const pid = Number(postId);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return null;
  return { modelId: Number(modelId), postId: pid };
}
module.exports = { saveParams };
