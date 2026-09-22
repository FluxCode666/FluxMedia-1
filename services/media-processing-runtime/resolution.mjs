export function parseImageSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(size || "");
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  if (width < 1 || height < 1 || width * height > 268402689) return null;
  return { width, height };
}
