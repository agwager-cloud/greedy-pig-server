export function generateRoomCode(length = 4): string {
  const digits = "0123456789";
  let code = "";

  for (let i = 0; i < length; i++) {
    code += digits[Math.floor(Math.random() * digits.length)];
  }

  return code;
}
