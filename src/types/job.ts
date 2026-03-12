export interface Job {
  id: string;
  title: string;
  company: string;
  description: string;
  url: string;
  isDirect: boolean;
  email?: string | null | undefined;
  location?: string;
  source: 'LinkedIn' | 'X' | 'HackerNews';
}
