function initialWindowBounds(area) {
  const width = Math.min(1280, area.width - 32);
  const height = Math.min(820, area.height - 32);
  return { x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2), width, height };
}

module.exports = { initialWindowBounds };
