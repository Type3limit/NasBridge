// Art slots used by the tactical UI. Each slot currently reuses an existing
// webp; once the images in src/assets/tactical-imagegen-prompts.json are
// generated, save them under src/assets/ with the listed file name and point
// the slot's import at it. Nothing else has to change.
import hall from "../assets/machine-hall.webp";
import assembly from "../assets/relay-assembly.webp";
import projector from "../assets/media-projector.webp";

export const tacticalArt = {
  backdrop: hall,        // -> tactical-backdrop.webp
  commandHero: hall,     // -> command-bridge.webp
  heroMachine: assembly, // -> relay-core.webp
  broadcastTile: projector, // -> broadcast-array.webp
  animeTile: projector   // -> anime-archive.webp
};
