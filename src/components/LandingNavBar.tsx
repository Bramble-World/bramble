export function LandingNavBar() {
  return (
    <nav className="flex items-center justify-between bg-gray-800 p-4 text-white">
      <div className="text-lg font-bold">MyApp</div>
      <div className="space-x-4">
        <a href="#" className="hover:underline">
          Home
        </a>
        <a href="#" className="hover:underline">
          About
        </a>
        <a href="#" className="hover:underline">
          Contact
        </a>
      </div>
    </nav>
  );
}
