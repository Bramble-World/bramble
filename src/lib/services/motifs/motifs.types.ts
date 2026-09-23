export type PublicMotif = {
  id: string;
  label: string;
  description: string | null;
};

export type NewMotif = {
  label: string;
  description?: string;
};
