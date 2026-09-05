/**
 * The page a phone opens: subscribe to held-queue notifications (Web Push, installable), and the
 * browser softphone that places the demonstration call as a Client SDK user.
 */
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/phone.css";
import { mountPhone } from "./phone/page.js";

const host = document.querySelector<HTMLElement>("[data-phone]");
if (host) mountPhone(host);
