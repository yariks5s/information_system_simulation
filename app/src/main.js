import { Lab } from "./ui/lab.js";
import { model, results, validation } from "./ui/results.js";
import { tooltip } from "./ui/dom.js";

function tabs(lab) {
  const buttons = [...document.querySelectorAll('nav.tabs [role="tab"]')];
  const built = new Set();
  const open = button => {
    for (const b of buttons) {
      const on = b === button;
      b.setAttribute("aria-selected", String(on));
      document.getElementById(b.getAttribute("aria-controls")).hidden = !on;
    }
    const id = button.getAttribute("aria-controls");
    if (!built.has(id)) {
      built.add(id);
      if (id === "tab-results") results();
      if (id === "tab-validation") validation();
    }
    if (id === "tab-results" || id === "tab-validation") lab.pause();  // the diagram tab shows the running model
    tooltip.hide();
    history.replaceState(null, "", "#" + id.slice(4));
  };
  buttons.forEach(b => b.addEventListener("click", () => open(b)));
  const initial = buttons.find(b => b.getAttribute("aria-controls") === "tab-" + location.hash.slice(1));
  if (initial) open(initial);
}

function theme(lab) {
  const button = document.getElementById("theme");
  const modes = ["auto", "light", "dark"], names = { auto: "авто", light: "світла", dark: "темна" };
  let mode = "auto";
  button.addEventListener("click", () => {
    mode = modes[(modes.indexOf(mode) + 1) % modes.length];
    if (mode === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", mode);
    button.textContent = "Тема: " + names[mode];
    lab.drawAll();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => lab.drawAll());
}

const lab = new Lab();
window.lab = lab;  // for the browser tests and the console
model();
tabs(lab);
theme(lab);
