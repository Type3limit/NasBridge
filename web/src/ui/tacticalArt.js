// Generated from src/assets/refined-imagegen-prompts.json.
import accessHero from "../assets/access-hero.webp";
import commandHero from "../assets/command-hero.webp";
import broadcastLine from "../assets/line-broadcast.webp";
import animeLine from "../assets/line-anime.webp";

export const tacticalArt = {
  accessHero,
  commandHero,
  broadcastTile: broadcastLine,
  animeTile: animeLine
};

// The old colour scenes get desaturated while they stand in; the refined
// scenes are already graded, so they render untouched once imported above.
const PLACEHOLDER_SCENES = /(relay-station|machine-hall)/;
export function sceneClass(src) {
  return PLACEHOLDER_SCENES.test(String(src)) ? "tacScene tacScenePlaceholder" : "tacScene";
}
