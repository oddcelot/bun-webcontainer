import "virtual:uno.css";
import "./configure.css";
import "../../embed-element/index";
import { render } from "@solidjs/web";
import { Configurator } from "./Configurator";

render(() => <Configurator />, document.body);
