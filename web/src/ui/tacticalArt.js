// Scene slots used by the tactical UI. Each one currently points at a
// placeholder; when the files from src/assets/refined-imagegen-prompts.json
// are generated, save them under src/assets/ and change only the import.
import accessHero from "../assets/relay-station.webp"; // -> ../assets/access-hero.webp
import commandHero from "../assets/machine-hall.webp"; // -> ../assets/command-hero.webp
import broadcastLine from "../assets/placeholders/line-broadcast.svg"; // -> ../assets/line-broadcast.webp
import animeLine from "../assets/placeholders/line-anime.svg"; // -> ../assets/line-anime.webp

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
