import msg from "virtual:greeting";
import { add } from "@alias/math";
import note from "./note.txt";
import cfg from "./config.yaml";
console.log(msg, add(1, 2), note, cfg.name);
