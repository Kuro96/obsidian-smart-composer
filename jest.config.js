/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/__mocks__/obsidian.ts',
  },
  transform: {
    '^.+.tsx?$': ['ts-jest', {}],
  },
  modulePathIgnorePatterns: ['<rootDir>/tmp/'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tmp/'],
  maxWorkers: 1,
}
