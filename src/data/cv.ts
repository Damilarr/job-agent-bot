export interface MasterCV {
  name: string;
  title: string;
  portfolio: string;
  summary: string;
  skills: {
    languages: string[];
    frameworks: string[];
    tools: string[];
  };
  experience: {
    role: string;
    company: string;
    duration: string;
    highlights: string[];
  }[];
  education: {
    degree: string;
    institution: string;
    graduationYear: string;
  }[];
}


export const myCV: MasterCV = {
  name: "Emmanuel Adeyemo",
  title: "Frontend Developer",
  portfolio: "https://damilarr.dev",
  summary: "A passionate Frontend Developer with experience building scalable web applications, AI-powered tools, and interactive user interfaces. Strong focus on modern JavaScript frameworks, performance optimization, and user-centric design.",
  skills: {
    languages: ["JavaScript", "TypeScript", "Dart", "HTML", "CSS"],
    frameworks: ["React", "Next.js", "Flutter", "Material UI", "TailwindCSS"],
    tools: ["Git", "Google Cloud Platform", "Cloudflare R2", "Cloudflare D1", "MongoDB", "Prisma", "NeonDB"],
  },
  experience: [
    {
      role: "Frontend Developer",
      company: "MyAI Robotics LLC",
      duration: "Oct 2024 – Nov 2025",
      highlights: [
        "Engineered a content authentication system that renders bounding-box overlays on media previews to highlight verified vs. unverified segments.",
        "Built a custom web search module integrating live data directly into the user's research workflow, ensuring up-to-date context for the AI agent.",
        "Implemented a report generation engine that exports complex authentication data into formatted PDFs for client documentation."
      ]
    },
    {
      role: "Frontend Developer",
      company: "Buildhubb (Tradeet)",
      duration: "May 2024 – Oct 2024",
      highlights: [
        "Translated UI/UX designs into interactive, high-performance web components.",
        "Collaborated with stakeholders to make strategic decisions for business growth.",
        "Enhanced website functionalities to improve user engagement and retention."
      ]
    },
    {
      role: "Intern Frontend Developer",
      company: "SQI College of ICT",
      duration: "Nov 2022 – Apr 2023",
      highlights: [
        "Mentored students in HTML, CSS, and JavaScript, simplifying complex concepts for beginners.",
        "Designed structured lesson plans and roadmaps to enhance student learning.",
        "Provided hands-on debugging assistance, improving students' problem-solving skills."
      ]
    }
  ],
  education: [
    {
      degree: "Bachelor of Engineering in Computer Engineering",
      institution: "University of Ilorin",
      graduationYear: "Present"
    }
  ]
};

/**
 * Helper function to format the CV into a text string suitable for the LLM prompt.
 */
export function formatCVForPrompt(cv: MasterCV): string {
  let text = `Name: ${cv.name}\n`;
  text += `Title: ${cv.title}\n`;
  text += `Portfolio: ${cv.portfolio}\n\n`;
  text += `Summary:\n${cv.summary}\n\n`;
  
  text += `Skills:\n`;
  text += `- Languages: ${cv.skills.languages.join(", ")}\n`;
  text += `- Frameworks: ${cv.skills.frameworks.join(", ")}\n`;
  text += `- Tools: ${cv.skills.tools.join(", ")}\n\n`;

  text += `Experience:\n`;
  cv.experience.forEach(exp => {
    text += `- ${exp.role} at ${exp.company} (${exp.duration})\n`;
    exp.highlights.forEach(highlight => {
      text += `  * ${highlight}\n`;
    });
  });
  text += `\n`;

  text += `Education:\n`;
  cv.education.forEach(edu => {
    text += `- ${edu.degree}, ${edu.institution} (${edu.graduationYear})\n`;
  });

  return text;
}
