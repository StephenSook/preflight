/**
 * The cockpit dashboard entry: six screens on hash routes (live, block, graph, held, log, setup),
 * the cockpit palette, the motion budget turned down to the row insertion, the block signature
 * and the button spring. The dashboard token is entered once and kept for the session.
 */
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/app.css";
import { mountCockpit } from "./app/cockpit.js";

const host = document.querySelector<HTMLElement>("[data-cockpit]");
if (host) mountCockpit(host);
