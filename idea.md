### The Product Vision: "The Immersive Reader"

#### 1. User Interface and User Experience (UI/UX)

The goal is to reduce cognitive load to an absolute minimum. The interface should be spartan, perhaps relying on menus and buttons with a flat, geometric vector design (2D *low-poly* style) that doesn't distract from reading.

* **Dark Mode (Recommended for immersion):** Deep black background. Words take on a tactical visual weight:
* **Known:** White or light gray (they blend into the background, zero friction).

* **Learning:** A metallic orange or gold tone (they subtly capture your attention).

* **Unknown:** Vibrant blood red (they stand out immediately as visual alerts).

* **Light Mode:** Pure white or sepia background. Known words in black. Orange and red maintain their alert hierarchy.

#### 2. Phase 1: Local Monolithic Architecture (The MVP)

Everything happens on your machine. This phase is perfect for rapid iteration and testing the concept yourself without spending a penny on servers.

* **Frontend:** Pure JavaScript, HTML5, and CSS. It captures the text, splits it into *tokens* (words), and colors it according to the state of each word.

* **Database:** To keep everything in a single local desktop/web application, you can use **SQLite compiled to WebAssembly (WASM)**. This gives you the full power of relational SQL queries directly in the browser, without the need for a traditional backend.

* **The "Brain":** The frontend makes local HTTP requests directly to your **Ollama** instance (`http://localhost:11434`), sending the text segment to generate the contextual dictionary.


* #### 3. Phase 2: Evolution to Client-Server (The Vision for the Future)

When the project matures, you want to sync your progress on your mobile device, or you decide to open the platform to other users (perhaps scaling to support multiple languages ​​globally), the monolith is divided.

| Component | Role in the Client-Server Architecture | Suggested Technology |

| --- | --- | --- |


**Frontend (Client)** | Visual rendering, user interactions, voice reader calls (Edge/Web Speech). | JS/Web Framework (React/Vue) or Mobile App. |

**Backend (Server)** | Orchestration. Receives the text, cross-references it with the user's database, and communicates securely with Ollama. | **Rust**. Provides extreme performance, impeccable memory management, and massive concurrency. |

**Database** | Centralized storage of user data, learning progress, and cached dictionaries. | Centralized PostgreSQL or SQLite. |

**AI Engine** | Ollama cluster hosted on your own server or in the cloud to process backend prompts. | Llama 3 or Phi-3. |

### The Data Lifecycle (Internal Process)

1. **Upload:** The user uploads the Harry Potter `.txt` file.

2. **Parse & Cross-reference:** The system cleans the punctuation and cross-references each unique word with the SQLite database to verify its status (Known, Learning, Unknown).

3. **Rendering:** The screen draws the text using the exact color code (White, Orange, Red).

4. **Interaction:** The user clicks on a red word.

5. **Inference:** The system takes the word and the complete sentence and pings Ollama.

6. **Answer:** Ollama returns a simple English definition, which is displayed on the screen.

7. **Update:** The user marks the word as "Learning." The UI highlights it in orange, and SQLite updates the status for future chapters.