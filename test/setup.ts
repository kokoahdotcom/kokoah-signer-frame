/** Every test file starts in a browser that shows the prompt is seen (IntersectionObserver v2, as in Chromium). */
import { installIntersectionObserver } from "./visibility.js";

if (typeof window !== "undefined") installIntersectionObserver(window, "occlusion");
