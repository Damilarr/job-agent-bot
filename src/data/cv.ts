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
  name: "John Doe",
  title: "Software Engineer",
  portfolio: "https://example.com",
  summary: "A passionate Software Engineer with experience building scalable web applications. Strong focus on modern JavaScript frameworks, performance optimization, and user-centric design.",
  skills: {
    languages: ["JavaScript", "TypeScript", "HTML", "CSS"],
    frameworks: ["React", "Node.js", "Express", "TailwindCSS"],
    tools: ["Git", "Docker", "AWS", "MongoDB"],
  },
  experience: [
    {
      role: "Software Engineer",
      company: "Tech Corp",
      duration: "Jan 2020 – Present",
      highlights: [
        "Developed scalable web components that improved user engagement by 20%.",
        "Collaborated with cross-functional teams to integrate new features into the core product.",
        "Mentored junior developers and performed code reviews."
      ]
    }
  ],
  education: [
    {
      degree: "Bachelor of Science in Computer Science",
      institution: "State University",
      graduationYear: "2019"
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
